// Pages HTML de l'interface. Toutes passent par le gabarit html`...` (server/html.js) :
// chaque valeur interpolée est échappée automatiquement.
// Aucun attribut style, aucune balise <style> ni <script> : la CSP les bloquerait, et toute
// la mise en forme est dans web/static/style.css.
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
  corrige: 'Localisation corrigée.',
  cree_puce: 'Fiche créée avec la puce scannée : la localisation suit désormais les scans de cette puce.',
  puce_associee: 'Puce associée : la localisation de la fiche suit désormais cette puce.',
  puce_remplacee: 'Puce remplacée : l\'ancienne puce est détachée, la localisation suit désormais la nouvelle.',
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
  desactive: 'Lecteur désactivé. Ses trames sont désormais refusées.',
};

const BRAND = html`<span class="marque"><span class="marque-logo" aria-hidden="true">MT</span>MetroTrack</span>`;

function documentPage(title, bodyClass, body) {
  return html`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · MetroTrack</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- hors session

// Page hors session (connexion, refus) : une carte centrée.
function cardLayout(title, content) {
  return documentPage(title, 'page-connexion', html`<main class="carte">
${BRAND}
${content}
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
<button class="bouton" type="submit">Se connecter</button>
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

// Rubriques du bandeau : l'inventaire (fiches), les postes et lecteurs, les puces inconnues.
// Pas de badge « nombre de puces inconnues » sur l'onglet : il serait calculé sur chaque page,
// et son calcul coûte environ 20 ms à 300 000 scans (server/chips.js), au-delà du budget fixé.
const SECTION_ITEMS = 'items';
const SECTION_STATIONS = 'stations';
const SECTION_CHIPS = 'chips';

/** Lien du bandeau : class="actif" dans sa rubrique, aria-current="page" sur la liste elle-même. */
function navLink(href, label, active, current) {
  return html`<a${active ? html` class="actif"` : null} href="${href}"${current ? html` aria-current="page"` : null}>${label}</a>`;
}

/**
 * Page de l'application : bandeau (marque, navigation, compte, déconnexion) puis contenu.
 * @param {{username: string, csrf: string}} user
 * @param {{section?: string, current?: string|null}} [options]
 *   section : rubrique active du bandeau ; current : href du lien du bandeau qui désigne
 *   exactement cette page (aria-current="page"), ou null.
 */
function appLayout(user, title, content, { section = SECTION_ITEMS, current = null } = {}) {
  return documentPage(title, 'page-app', html`<header class="barre">
<div class="barre-interieur">
<div class="barre-gauche">
${BRAND}
<nav class="navigation" aria-label="Navigation principale">
${navLink('/', 'Inventaire', section === SECTION_ITEMS, current === '/')}
${navLink('/stations', 'Postes et lecteurs', section === SECTION_STATIONS, current === '/stations')}
${navLink('/chips', 'Puces inconnues', section === SECTION_CHIPS, current === '/chips')}
</nav>
</div>
<div class="session">
<span>Connecté en tant que <strong>${user.username}</strong></span>
<form method="post" action="/logout">
<input type="hidden" name="csrf" value="${user.csrf}">
<button class="bouton bouton-secondaire" type="submit">Se déconnecter</button>
</form>
</div>
</div>
</header>
<main class="contenu">
${content}
</main>`);
}

/** Message de confirmation pour un code ?ok= connu, sinon rien. */
function noticeFor(notices, code) {
  if (typeof code !== 'string' || !Object.hasOwn(notices, code)) return null;
  return html`<p class="succes" role="status">${notices[code]}</p>\n`;
}

// Localisation d'une ligne (liste ou fiche) : libellé et état pour la puce de couleur.
function locationOf(row) {
  if (row.at === null) return { label: 'jamais localisé', state: 'jamais' };
  if (row.station_id === null) return { label: `inconnue (lecteur n° ${row.reader_id} non affecté)`, state: 'inconnue' };
  return { label: row.station_name, state: 'poste' };
}

// Puce de localisation. Scan sur un lecteur non affecté : la puce mène à la fiche du
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
    body = html`<div class="vide"><p>Aucun objet dans l'inventaire pour le moment.</p>
<p class="texte-doux">Créez la première fiche avec le bouton «&nbsp;Nouvelle fiche&nbsp;».</p></div>`;
  } else if (items.length === 0) {
    body = html`<div class="vide"><p>Aucun objet ne correspond à «&nbsp;${query}&nbsp;».</p>
<p class="texte-doux">Essayez une partie du nom, ou quelques caractères du numéro de sa puce.</p></div>`;
  } else {
    body = html`<div class="panneau-tableau">
<table class="tableau tableau-inventaire">
<thead><tr><th scope="col">Objet</th><th scope="col">Localisation</th><th scope="col">Depuis</th></tr></thead>
<tbody>
${items.map((item) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a>${item.uid_nfc === null ? null : html`<span class="uid">${item.uid_nfc}</span>`}</td>
<td data-label="Localisation">${locationBadge(item)}</td>
<td data-label="Depuis">${item.at === null ? html`<span class="texte-doux">—</span>` : arrivalTag(item, now)}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  }

  return appLayout(user, 'Inventaire', html`${noticeFor(LIST_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>Inventaire</h1>
<div class="actions-page">
<a class="bouton" href="/items/new">Nouvelle fiche</a>
</div>
</div>
${AIDE.inventaire}<form class="recherche" method="get" action="/" role="search">
<label class="visuellement-cache" for="q">Rechercher un objet par nom ou numéro de puce</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom ou numéro de puce" autocomplete="off" spellcheck="false">
<button class="bouton bouton-secondaire" type="submit">Rechercher</button>
</form>
${summary}
${body}`, { current: '/' });
}

/**
 * Fiche d'un objet.
 * @param {{item: object, scans: object[], history: object[], now: number, notice?: string|null}} data
 *   history : dernières modifications (items.js, itemHistory) ; notice : code ?ok= reçu
 */
export function itemPage(user, { item, scans, history = [], now, notice = null }) {
  let source;
  if (item.at === null) {
    source = html`<p class="texte-doux">${item.uid_nfc === null ? 'Aucune puce associée : l\'objet ne peut pas être localisé par un scan.' : 'Cette puce n\'a encore été scannée sur aucun poste.'}</p>`;
  } else {
    // D'abord l'heure d'arrivée à cet emplacement (« depuis »), puis le dernier événement. Si
    // l'objet y a été signalé à nouveau depuis son arrivée, l'heure de ce dernier signalement
    // est ajoutée. Remontée bornée : « depuis au moins » devant l'heure d'arrivée.
    const again = (item.arrived_at ?? item.at) !== item.at;
    const last = item.source === 'manual'
      ? html`${again ? html`dernière correction manuelle ${timeTag(item.at, now)}` : 'correction manuelle'} par ${item.corrected_by ?? 'un compte inconnu'}`
      : html`${again ? html`dernier scan ${timeTag(item.at, now)}` : 'scan'}, lecteur n° ${item.reader_id}`;
    source = html`<p class="localisation-detail">${arrivalTag(item, now, 'depuis au moins')} · ${last}</p>`;
  }

  const properties = item.properties.length === 0
    ? html`<p class="texte-doux">Aucune propriété</p>`
    : html`<dl class="proprietes">
${item.properties.map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>
`)}</dl>`;

  const notes = item.notes.trim() === ''
    ? html`<p class="texte-doux">Aucune note</p>`
    : html`<p class="notes">${item.notes}</p>`;

  let scanHistory;
  if (item.uid_nfc === null) scanHistory = html`<p class="texte-doux">Aucune puce associée.</p>`;
  else if (scans.length === 0) scanHistory = html`<p class="texte-doux">Aucun scan pour cette puce.</p>`;
  else {
    scanHistory = html`<table class="tableau tableau-scans">
<thead><tr><th scope="col">Poste</th><th scope="col">Heure</th></tr></thead>
<tbody>
${scans.map((scan) => html`<tr>
<td data-label="Poste">${scan.station_id === null ? html`<span class="texte-doux">lecteur n° ${scan.reader_id} non affecté</span>` : scan.station_name}</td>
<td data-label="Heure">${timeTag(scan.received_at, now)}</td>
</tr>
`)}</tbody>
</table>`;
  }

  const changes = history.length === 0
    ? html`<p class="texte-doux">Aucune modification enregistrée.</p>`
    : html`<table class="tableau tableau-modifications">
<thead><tr><th scope="col">Date</th><th scope="col">Auteur</th><th scope="col">Modification</th></tr></thead>
<tbody>
${history.map((entry) => html`<tr>
<td data-label="Date">${timeTag(entry.at, now)}</td>
<td data-label="Auteur">${entry.username ?? html`<span class="texte-doux">ligne de commande</span>`}</td>
<td data-label="Modification">${historyLabel(entry.label)}</td>
</tr>
`)}</tbody>
</table>`;

  return appLayout(user, item.name, html`<p class="retour"><a href="/">← Inventaire</a></p>
${noticeFor(ITEM_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>${item.name}</h1>
<div class="actions-page">
<a class="bouton" href="/items/${item.id}/edit">Modifier</a>
<a class="bouton bouton-secondaire" href="/items/${item.id}/location">Corriger la localisation</a>
<a class="lien-danger" href="/items/${item.id}/delete">Supprimer</a>
</div>
</div>
${AIDE.fiche}<div class="fiche">
<section class="fiche-carte" aria-labelledby="titre-localisation">
<h2 id="titre-localisation">Localisation actuelle</h2>
<p>${locationBadge(item)}</p>
${source}
</section>
<section class="fiche-carte" aria-labelledby="titre-identification">
<h2 id="titre-identification">Identification</h2>
<dl class="proprietes">
<div><dt>Puce NFC</dt><dd>${item.uid_nfc === null ? html`<span class="texte-doux">aucune puce associée</span>` : html`<span class="uid">${item.uid_nfc}</span>`}</dd></div>
<div><dt>Créée</dt><dd>${formatDateTime(item.created_at)}</dd></div>
<div><dt>Modifiée</dt><dd>${formatDateTime(item.updated_at)}</dd></div>
</dl>
${item.uid_nfc === null ? html`<p class="note-carte">Pour localiser l'objet, scannez sa puce sur un poste, puis associez-la depuis <a href="/chips">Puces inconnues</a>.</p>\n` : null}</section>
<section class="fiche-carte" aria-labelledby="titre-proprietes">
<h2 id="titre-proprietes">Propriétés</h2>
${properties}
</section>
<section class="fiche-carte" aria-labelledby="titre-notes">
<h2 id="titre-notes">Notes</h2>
${notes}
</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-scans">
<h2 id="titre-scans">Derniers scans</h2>
${scanHistory}
</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-modifications">
<h2 id="titre-modifications">Historique des modifications</h2>
${changes}
</section>
</div>`);
}

/**
 * Libellé d'une ligne d'historique (items.js, auditLabel) : texte, ou segments dont les UID
 * {uid} sont affichés en chasse fixe. Chaque segment passe par le gabarit (échappé).
 */
function historyLabel(label) {
  if (!Array.isArray(label)) return label;
  return label.map((part) => (typeof part === 'string' ? part : html`<span class="uid">${part.uid}</span>`));
}

export function itemNotFoundPage(user) {
  return appLayout(user, 'Fiche introuvable', html`<p class="retour"><a href="/">← Inventaire</a></p>
<div class="vide">
<h1>Fiche introuvable</h1>
<p class="texte-doux">Aucun objet ne correspond à cette adresse.</p>
</div>`);
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
  let back = '← Inventaire';
  if (editing) {
    action = `/items/${item.id}/edit`;
    cancel = `/items/${item.id}`;
    back = '← Retour à la fiche';
  } else if (chip !== null) {
    action = `/chips/${chip.uid}/new`;
    cancel = '/chips';
    back = '← Puces inconnues';
  }
  const title = editing ? 'Modifier la fiche' : 'Nouvelle fiche';
  let help = AIDE.nouvelleFiche;
  if (editing) help = AIDE.modifierFiche;
  else if (chip !== null) help = AIDE.ficheDepuisPuce;
  const failed = Object.keys(errors).length > 0 || form.rows.some((row) => row.error !== null);
  const rows = [...form.rows, ...Array(form.blankRows).fill(EMPTY_ROW)];
  const chipField = chip === null ? null : html`<div class="champ">
<p class="libelle">Puce NFC</p>
<p class="puce-lecture"><span class="uid">${chip.uid}</span></p>
<p class="aide">Dernier scan : ${chipPlace(chip)}, ${timeTag(chip.received_at, now)}. Dès la création, l'objet est localisé à ce scan.</p>
</div>
`;

  return appLayout(user, title, html`<p class="retour"><a href="${cancel}">${back}</a></p>
<div class="entete-page">
<h1>${title}</h1>
${editing ? html`<p class="sous-titre-page">${item.name}</p>\n` : null}</div>
${help}${failed ? html`<p class="erreur" role="alert">La fiche n'a pas été enregistrée. Corrigez les champs signalés en rouge : votre saisie est conservée.</p>\n` : null}${chip === null ? null : reuseWarning(chip)}<form class="formulaire-page" method="post" action="${action}">
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
  return appLayout(user, 'Supprimer la fiche', html`<p class="retour"><a href="/items/${item.id}">← Retour à la fiche</a></p>
<div class="entete-page">
<h1>Supprimer la fiche</h1>
</div>
${AIDE.supprimerFiche}<div class="panneau panneau-danger">
<p>Vous allez supprimer la fiche «&nbsp;<strong class="nom-confirme">${item.name}</strong>&nbsp;».</p>
<p>Ses propriétés, ses notes et l'historique de ses corrections manuelles de localisation seront supprimés avec elle.</p>
${item.uid_nfc === null ? null : html`<p>Sa puce <span class="uid">${item.uid_nfc}</span> sera détachée : si elle a déjà été scannée, elle réapparaîtra dans «&nbsp;Puces inconnues&nbsp;» avec ses scans.</p>\n`}<p class="texte-doux">Le journal des scans de sa puce et le journal des modifications sont conservés.</p>
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
 * Correction manuelle de localisation.
 * @param {{item: object, stations: {id: number, name: string}[], selected?: string|null, error?: string|null}} data
 *   item : fiche avec sa localisation (getItem) ; selected : valeur choisie à réafficher.
 */
export function locationPage(user, { item, stations, selected = null, error = null }) {
  const current = html`<p class="localisation-actuelle"><span class="texte-doux">Localisation actuelle :</span> ${locationBadge(item)}</p>`;
  let body;
  if (stations.length === 0) {
    body = html`<div class="vide"><p>Aucun poste n'existe encore.</p>
<p class="texte-doux">Il faut d'abord créer un poste pour pouvoir y localiser un objet.</p>
<a class="bouton" href="/stations/new">Créer un poste</a></div>`;
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
  return appLayout(user, 'Corriger la localisation', html`<p class="retour"><a href="/items/${item.id}">← Retour à la fiche</a></p>
<div class="entete-page">
<h1>Corriger la localisation</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.localisation}${current}
${body}`);
}

// ---------------------------------------------------------------- postes et lecteurs (étape 6)

const stationsSection = { section: SECTION_STATIONS };
const BACK_TO_STATIONS = html`<p class="retour"><a href="/stations">← Postes et lecteurs</a></p>`;
const BACK_TO_READERS = html`<p class="retour"><a href="/readers">← Lecteurs</a></p>`;

/** Onglets « Postes » et « Lecteurs » en tête des deux listes ; current : '/stations' ou '/readers'. */
function sectionTabs(current) {
  const tab = (href, label) => html`<a${href === current ? html` class="actif" aria-current="page"` : null} href="${href}">${label}</a>`;
  return html`<nav class="onglets" aria-label="Postes et lecteurs">
${tab('/stations', 'Postes')}
${tab('/readers', 'Lecteurs')}
</nav>`;
}

/** En-tête commun des deux listes : titre de la rubrique, bouton principal, onglets. */
function sectionHeader(current, button) {
  return html`<div class="entete-page entete-actions">
<h1>Postes et lecteurs</h1>
<div class="actions-page">
${button}
</div>
</div>
${sectionTabs(current)}`;
}

/**
 * Page d'information (introuvable, action impossible) : encadré centré.
 * layout : rubrique du bandeau (postes et lecteurs par défaut, ou puces inconnues).
 */
function messagePage(user, { title, text, hint = null, back, action = null, layout = stationsSection }) {
  return appLayout(user, title, html`${back}
<div class="vide">
<h1>${title}</h1>
<p>${text}</p>
${hint === null ? null : html`<p class="texte-doux">${hint}</p>\n`}${action === null ? null : html`<a class="bouton" href="${action.href}">${action.label}</a>\n`}</div>`, layout);
}

export function stationNotFoundPage(user) {
  return messagePage(user, { title: 'Poste introuvable', text: 'Aucun poste ne correspond à cette adresse.', back: BACK_TO_STATIONS });
}

export function readerNotFoundPage(user) {
  return messagePage(user, { title: 'Lecteur introuvable', text: 'Aucun lecteur ne correspond à cette adresse.', back: BACK_TO_READERS });
}

/** Action impossible sur un lecteur désactivé (affectation, remplacement, désactivation). */
export function readerInactivePage(user, { reader }) {
  return messagePage(user, {
    title: 'Lecteur désactivé',
    text: `Le lecteur n° ${reader.id} est désactivé définitivement : il ne peut plus changer de poste, ni être désactivé ou remplacé une seconde fois.`,
    hint: 'Pour remettre un boîtier en service, créez un nouveau lecteur.',
    back: html`<p class="retour"><a href="/readers/${reader.id}">← Retour au lecteur</a></p>`,
    action: { href: '/readers/new', label: 'Nouveau lecteur' },
  });
}

/** Plus aucun identifiant de lecteur libre (reader_id sur 32 bits). */
export function readerIdsExhaustedPage(user) {
  return messagePage(user, {
    title: 'Aucun numéro de lecteur disponible',
    text: `Le plus grand numéro de lecteur possible (${thousands(MAX_READER_ID)}) est déjà attribué : aucun nouveau lecteur ne peut être créé.`,
    hint: 'Rien n\'a été modifié.',
    back: BACK_TO_READERS,
  });
}

// État d'un lecteur : puce verte (actif) ou grise (désactivé).
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
    ? html`<div class="vide"><p>Aucun poste pour le moment.</p>
<p class="texte-doux">Créez le premier poste avec le bouton «&nbsp;Nouveau poste&nbsp;», puis affectez-lui un lecteur.</p></div>`
    : html`<div class="panneau-tableau">
<table class="tableau tableau-postes">
<thead><tr><th scope="col">Poste</th><th scope="col">Lecteurs actifs</th><th scope="col">Objets présents</th></tr></thead>
<tbody>
${stations.map((station) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/stations/${station.id}">${station.name}</a>${station.description === '' ? null : html`<span class="description-courte">${station.description}</span>`}</td>
<td data-label="Lecteurs actifs">${station.active_readers}</td>
<td data-label="Objets présents">${station.items_here}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  return appLayout(user, 'Postes', html`${noticeFor(STATION_LIST_NOTICES, notice)}${sectionHeader('/stations', html`<a class="bouton" href="/stations/new">Nouveau poste</a>`)}
${AIDE.postes}<p class="resultats">${plural(stations.length, 'poste', 'postes')}</p>
${body}`, { ...stationsSection, current: '/stations' });
}

/**
 * Fiche d'un poste.
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
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a>${item.uid_nfc === null ? null : html`<span class="uid">${item.uid_nfc}</span>`}</td>
<td data-label="Depuis">${arrivalTag(item, now)}${item.arrival_source === 'manual' ? html` <span class="texte-doux">(correction)</span>` : null}</td>
</tr>
`)}</tbody>
</table>`;

  return appLayout(user, station.name, html`${BACK_TO_STATIONS}
${noticeFor(STATION_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>${station.name}</h1>
<div class="actions-page">
<a class="bouton" href="/stations/${station.id}/edit">Modifier</a>
${deletable ? html`<a class="lien-danger" href="/stations/${station.id}/delete">Supprimer</a>` : null}
</div>
</div>
${AIDE.poste}<div class="fiche">
<section class="fiche-carte" aria-labelledby="titre-description">
<h2 id="titre-description">Description</h2>
${description}
</section>
<section class="fiche-carte" aria-labelledby="titre-informations">
<h2 id="titre-informations">Informations</h2>
<dl class="proprietes">
<div><dt>Créé</dt><dd>${formatDateTime(station.created_at)}</dd></div>
<div><dt>Lecteurs actifs</dt><dd>${activeCount}</dd></div>
<div><dt>Objets présents</dt><dd>${items.length}</dd></div>
</dl>
${deletable ? null : html`<p class="note-poste">Ce poste a un historique (scans, corrections ou lecteurs) : il ne peut pas être supprimé, mais vous pouvez le renommer.</p>\n`}</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-lecteurs">
<h2 id="titre-lecteurs">Lecteurs</h2>
${readerList}
</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-objets">
<h2 id="titre-objets">Objets présents</h2>
${itemList}
</section>
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
  const failed = Object.keys(errors).length > 0;
  return appLayout(user, title, html`<p class="retour"><a href="${cancel}">${editing ? '← Retour au poste' : '← Postes et lecteurs'}</a></p>
<div class="entete-page">
<h1>${title}</h1>
${editing ? html`<p class="sous-titre-page">${station.name}</p>\n` : null}</div>
${editing ? AIDE.modifierPoste : AIDE.nouveauPoste}${failed ? html`<p class="erreur" role="alert">Le poste n'a pas été enregistré. Corrigez les champs signalés en rouge : votre saisie est conservée.</p>\n` : null}<form class="formulaire-page" method="post" action="${action}">
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
  const back = html`<p class="retour"><a href="/stations/${station.id}">← Retour au poste</a></p>`;
  if (hasHistory(history)) {
    const counted = (n, one, many) => `${thousands(n)} ${n > 1 ? many : one}`;
    const causes = [
      history.scans > 0 ? `${counted(history.scans, 'scan enregistré', 'scans enregistrés')} à ce poste` : null,
      history.corrections > 0 ? `${counted(history.corrections, 'correction manuelle', 'corrections manuelles')} de localisation vers ce poste` : null,
      history.readers > 0 ? `${counted(history.readers, 'lecteur affecté', 'lecteurs affectés')} à ce poste (actifs ou désactivés)` : null,
    ].filter((cause) => cause !== null);
    return appLayout(user, 'Suppression impossible', html`${back}
<div class="entete-page">
<h1>Suppression impossible</h1>
<p class="sous-titre-page">${station.name}</p>
</div>
<div class="panneau panneau-info">
<p>Ce poste ne peut pas être supprimé, car il a un historique&nbsp;:</p>
<ul class="liste-causes">
${causes.map((cause) => html`<li>${cause}</li>
`)}</ul>
<p class="texte-doux">Le journal des scans et des corrections désigne ce poste : il doit être conservé. Si le poste a changé de nom ou d'usage, renommez-le.</p>
<div class="actions-formulaire">
<a class="bouton" href="/stations/${station.id}/edit">Renommer le poste</a>
<a class="lien-annuler" href="/stations/${station.id}">Retour au poste</a>
</div>
</div>`, stationsSection);
  }
  return appLayout(user, 'Supprimer le poste', html`${back}
<div class="entete-page">
<h1>Supprimer le poste</h1>
</div>
${AIDE.supprimerPoste}<div class="panneau panneau-danger">
<p>Vous allez supprimer le poste «&nbsp;<strong class="nom-confirme">${station.name}</strong>&nbsp;».</p>
<p class="texte-doux">Il n'a aucun historique : aucun scan, aucune correction de localisation, aucun lecteur. Le journal des modifications garde la trace de la suppression.</p>
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
    ? html`<div class="vide"><p>Aucun lecteur pour le moment.</p>
<p class="texte-doux">Créez un lecteur avec le bouton «&nbsp;Nouveau lecteur&nbsp;» : le serveur lui attribue un numéro et une clé, à injecter dans le boîtier.</p></div>`
    : html`<div class="panneau-tableau">
<table class="tableau tableau-lecteurs">
<thead><tr><th scope="col">Lecteur</th><th scope="col">Poste</th><th scope="col">État</th><th scope="col">Dernier scan</th><th scope="col">Dernier compteur</th><th scope="col">Créé</th></tr></thead>
<tbody>
${readers.map((reader) => html`<tr>
<td><a class="lien-objet" href="/readers/${reader.id}">Lecteur n° ${reader.id}</a></td>
<td data-label="Poste">${stationLink(reader.station_id, reader.station_name)}</td>
<td data-label="État">${readerBadge(reader)}</td>
<td data-label="Dernier scan">${reader.last_scan_at === null ? html`<span class="texte-doux">aucun</span>` : timeTag(reader.last_scan_at, now)}</td>
<td data-label="Dernier compteur">${reader.last_counter === null ? html`<span class="texte-doux">—</span>` : reader.last_counter}</td>
<td data-label="Créé">${formatDateTime(reader.created_at)}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  return appLayout(user, 'Lecteurs', html`${sectionHeader('/readers', html`<a class="bouton" href="/readers/new">Nouveau lecteur</a>`)}
${AIDE.lecteurs}<p class="resultats">${plural(readers.length, 'lecteur', 'lecteurs')}${readers.length === 0 ? null : html` · ${plural(activeCount, 'actif', 'actifs')}`}</p>
${body}`, stationsSection);
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
<thead><tr><th scope="col">Puce</th><th scope="col">Objet</th><th scope="col">Poste</th><th scope="col">Heure</th></tr></thead>
<tbody>
${scans.map((scan) => html`<tr>
<td><span class="uid">${scan.uid_nfc}</span></td>
<td data-label="Objet">${scan.item_id === null ? html`<span class="texte-doux">puce inconnue</span>` : html`<a class="lien-simple" href="/items/${scan.item_id}">${scan.item_name}</a>`}</td>
<td data-label="Poste">${stationLink(scan.station_id, scan.station_name)}</td>
<td data-label="Heure">${timeTag(scan.received_at, now)}</td>
</tr>
`)}</tbody>
</table>`;

  return appLayout(user, `Lecteur n° ${reader.id}`, html`${BACK_TO_READERS}
${noticeFor(READER_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>Lecteur n° ${reader.id}</h1>
${actions}
</div>
${AIDE.lecteur}<div class="fiche">
<section class="fiche-carte" aria-labelledby="titre-etat">
<h2 id="titre-etat">État</h2>
<p>${readerBadge(reader)}</p>
<p class="localisation-detail">${active
    ? 'Ses trames sont acceptées. Sa clé n\'est jamais réaffichée : si elle est perdue, remplacez la clé.'
    : 'Désactivé définitivement : ses trames sont refusées. Ses scans passés sont conservés.'}</p>
</section>
<section class="fiche-carte" aria-labelledby="titre-identification">
<h2 id="titre-identification">Identification</h2>
<dl class="proprietes">
<div><dt>Poste</dt><dd>${stationLink(reader.station_id, reader.station_name)}</dd></div>
<div><dt>Créé</dt><dd>${formatDateTime(reader.created_at)}</dd></div>
<div><dt>Dernier scan</dt><dd>${reader.last_scan_at === null ? html`<span class="texte-doux">aucun</span>` : timeTag(reader.last_scan_at, now)}</dd></div>
<div><dt>Dernier compteur</dt><dd>${reader.last_counter === null ? html`<span class="texte-doux">—</span>` : reader.last_counter}</dd></div>
</dl>
</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-scans">
<h2 id="titre-scans">Derniers scans</h2>
${scanList}
</section>
</div>`, stationsSection);
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
  return appLayout(user, 'Nouveau lecteur', html`${BACK_TO_READERS}
<div class="entete-page">
<h1>Nouveau lecteur</h1>
</div>
${AIDE.nouveauLecteur}<form class="formulaire-page" method="post" action="/readers/new">
<input type="hidden" name="csrf" value="${user.csrf}">
${stationSelect({ stations, selected, error, help: 'Facultatif : le lecteur peut être affecté à un poste plus tard.' })}
<p class="aide">Le serveur attribue le numéro du lecteur et génère sa clé. La clé sera affichée une seule fois, sur la page suivante, pour être injectée dans le boîtier.</p>
<div class="actions-formulaire">
<button class="bouton" type="submit">Créer le lecteur</button>
<a class="lien-annuler" href="/readers">Annuler</a>
</div>
</form>`, stationsSection);
}

/**
 * Changement de poste d'un lecteur actif.
 * @param {{reader: object, stations: {id, name}[], selected?: string|null, error?: string|null}} data
 *   selected : valeur à présélectionner (par défaut le poste actuel).
 */
export function readerStationPage(user, { reader, stations, selected = null, error = null }) {
  const current = selected ?? (reader.station_id === null ? '' : String(reader.station_id));
  return appLayout(user, 'Changer de poste', html`<p class="retour"><a href="/readers/${reader.id}">← Retour au lecteur</a></p>
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
</form>`, stationsSection);
}

/** Confirmation de désactivation (définitive) d'un lecteur actif. */
export function deactivateReaderPage(user, { reader }) {
  return appLayout(user, 'Désactiver le lecteur', html`<p class="retour"><a href="/readers/${reader.id}">← Retour au lecteur</a></p>
<div class="entete-page">
<h1>Désactiver le lecteur</h1>
<p class="sous-titre-page">Lecteur n° ${reader.id} · ${reader.station_id === null ? 'non affecté' : reader.station_name}</p>
</div>
${AIDE.desactiverLecteur}<div class="panneau panneau-danger">
<p>Ses trames seront refusées dès maintenant.</p>
<p><strong>La désactivation est définitive</strong> : un lecteur désactivé ne peut pas être réactivé. Pour remettre le boîtier en service, il faudra créer un nouveau lecteur.</p>
<p class="texte-doux">Ses scans passés et les localisations qui en découlent sont conservés.</p>
<form method="post" action="/readers/${reader.id}/deactivate">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Désactiver définitivement</button>
<a class="lien-annuler" href="/readers/${reader.id}">Annuler</a>
</div>
</form>
</div>`, stationsSection);
}

/** Confirmation du remplacement de clé d'un lecteur actif. */
export function replaceReaderPage(user, { reader }) {
  const station = reader.station_id === null ? 'non affecté' : reader.station_name;
  return appLayout(user, 'Remplacer la clé', html`<p class="retour"><a href="/readers/${reader.id}">← Retour au lecteur</a></p>
<div class="entete-page">
<h1>Remplacer la clé</h1>
<p class="sous-titre-page">Lecteur n° ${reader.id} · ${station}</p>
</div>
${AIDE.remplacerCle}<div class="panneau panneau-danger">
<p>Un <strong>nouveau lecteur</strong> sera créé, avec un nouveau numéro et une nouvelle clé, au même poste (${station}).</p>
<p>Le lecteur n° ${reader.id} sera <strong>désactivé définitivement</strong> : ses trames seront refusées dès maintenant, jusqu'à ce que le boîtier reçoive le nouveau numéro et la nouvelle clé.</p>
<p class="texte-doux">La nouvelle clé sera affichée une seule fois, sur la page suivante : préparez-vous à l'injecter dans le boîtier. Les scans passés sont conservés.</p>
<form method="post" action="/readers/${reader.id}/replace">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Remplacer la clé</button>
<a class="lien-annuler" href="/readers/${reader.id}">Annuler</a>
</div>
</form>
</div>`, stationsSection);
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
  return appLayout(user, `Clé du lecteur n° ${id}`, html`<p class="succes" role="status">${done}</p>
<div class="entete-page">
<h1>Clé du lecteur n° ${id}</h1>
<p class="sous-titre-page">Poste : ${station === null ? 'non affecté' : station.name}</p>
</div>
<div class="panneau panneau-alerte" role="alert">
<p><strong>Cette clé ne sera plus jamais affichée.</strong> Injectez-la maintenant dans le boîtier, avec son numéro de lecteur. Si elle est perdue, remplacez la clé depuis la fiche du lecteur.</p>
<p>Ne rechargez pas cette page : le navigateur proposerait de renvoyer le formulaire, ce qui créerait un autre lecteur.</p>
<p>Fermez cet onglet une fois la clé injectée dans le boîtier.</p>
</div>
<div class="fiche">
<section class="fiche-carte fiche-large" aria-labelledby="titre-numero">
<h2 id="titre-numero">Numéro du lecteur</h2>
<p class="numero-lecteur">${id}</p>
<h2 id="titre-cle">Clé AES-256 (64 caractères hexadécimaux)</h2>
<pre class="cle">${keyHex}</pre>
<p class="aide">Un clic sur la clé la sélectionne en entier.</p>
</section>
</div>
<div class="actions-formulaire">
<a class="bouton" href="/readers">Retour aux lecteurs</a>
</div>`, stationsSection);
}

// ---------------------------------------------------------------- puces inconnues (étape 7)
// Les adresses /chips/<UID>/... ne contiennent qu'un UID validé (inventory.js, parseUid :
// hexadécimal majuscule de 8, 14 ou 20 caractères) ou lu en base au même format, et des
// identifiants entiers lus en base.

const chipsSection = { section: SECTION_CHIPS };
const BACK_TO_CHIPS = html`<p class="retour"><a href="/chips">← Puces inconnues</a></p>`;

/** Lieu du dernier scan d'une puce, en texte : nom du poste, ou lecteur non affecté (lien vers le lecteur). */
function chipPlace(chip) {
  return chip.station_id === null
    ? html`<a class="lien-simple" href="/readers/${chip.reader_id}">lecteur n° ${chip.reader_id} non affecté</a>`
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

/** Même information en puce d'état (liste) : verte pour un poste, orange pour un lecteur non affecté. */
function chipBadge(chip) {
  return chip.station_id === null
    ? html`<a class="lien-etat" href="/readers/${chip.reader_id}"><span class="etat etat-inconnue">lecteur n° ${chip.reader_id} non affecté</span></a>`
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
    ? html`<div class="vide"><p>Aucune puce inconnue : toutes les puces scannées sont associées à une fiche.</p>
<p class="texte-doux">Une puce scannée sur un poste sans fiche apparaîtra ici, avec le poste et l'heure de son dernier scan.</p></div>`
    : html`<div class="panneau-tableau">
<table class="tableau tableau-puces">
<thead><tr><th scope="col">Puce</th><th scope="col">Dernier poste</th><th scope="col">Dernier scan</th><th scope="col">Scans</th><th scope="col"><span class="visuellement-cache">Actions</span></th></tr></thead>
<tbody>
${chips.map((chip) => html`<tr>
<td><span class="uid uid-puce">${chip.uid}</span></td>
<td data-label="Dernier poste">${chipBadge(chip)}</td>
<td data-label="Dernier scan">${timeTag(chip.received_at, now)}</td>
<td data-label="Scans">${thousands(chip.scan_count)}</td>
<td class="cellule-actions"><a class="bouton bouton-secondaire" href="/chips/${chip.uid}/new">Créer une fiche</a>
<a class="lien-simple" href="/chips/${chip.uid}/associate">Associer à une fiche existante</a></td>
</tr>
`)}</tbody>
</table>
</div>`;
  return appLayout(user, 'Puces inconnues', html`<div class="entete-page">
<h1>Puces inconnues</h1>
<p class="intro">Puces scannées sur un poste qu'aucune fiche ne porte encore. Créez une fiche, ou associez la puce à une fiche existante : l'objet sera localisé au poste de son dernier scan.</p>
</div>
${AIDE.puces}${summary}
${body}`, { ...chipsSection, current: '/chips' });
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
    body = html`<div class="vide"><p>Aucune fiche dans l'inventaire.</p>
<p class="texte-doux">Créez plutôt une fiche pour cette puce.</p>
<a class="bouton" href="/chips/${chip.uid}/new">Créer une fiche</a></div>`;
  } else if (total === 0) {
    body = html`<div class="vide"><p>Aucune fiche ne correspond à «&nbsp;${query}&nbsp;».</p>
<p class="texte-doux">Essayez une partie du nom, ou quelques caractères du numéro de sa puce actuelle.</p></div>`;
  } else {
    body = html`<div class="panneau-tableau">
<table class="tableau tableau-association">
<thead><tr><th scope="col">Objet</th><th scope="col">Puce actuelle</th><th scope="col">Localisation</th><th scope="col"><span class="visuellement-cache">Action</span></th></tr></thead>
<tbody>
${items.map((item) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a></td>
<td data-label="Puce actuelle">${item.uid_nfc === null ? html`<span class="texte-doux">aucune puce</span>` : html`<span class="uid">${item.uid_nfc}</span>`}</td>
<td data-label="Localisation">${locationBadge(item)}</td>
<td class="cellule-actions"><a class="bouton bouton-secondaire" href="${base}/${item.id}">Associer</a></td>
</tr>
`)}</tbody>
</table>
</div>`;
  }

  return appLayout(user, 'Associer la puce', html`${BACK_TO_CHIPS}
<div class="entete-page">
<h1>Associer la puce à une fiche</h1>
<p class="sous-titre-page"><span class="uid">${chip.uid}</span> · dernier scan : ${chipPlace(chip)}, ${timeTag(chip.received_at, now)}</p>
</div>
${AIDE.associerRecherche}<form class="recherche" method="get" action="${base}" role="search">
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
 *   item : fiche avec sa localisation (inventory.js, getItem) ; changed : l'envoi précédent a
 *   été refusé parce que la fiche avait changé de puce entre-temps (page réaffichée en 409).
 */
export function associateConfirmPage(user, { chip, item, now, changed = false }) {
  const replacing = item.uid_nfc !== null;
  const title = replacing ? 'Remplacer la puce de la fiche' : 'Associer la puce';
  const search = `/chips/${chip.uid}/associate`;
  const lastScan = html`${chipPlace(chip)}, ${timeTag(chip.received_at, now)}`;
  // Sémantique de la vue item_locations : la plus récente des deux l'emporte. Une correction
  // manuelle postérieure au dernier scan de la puce reste donc la localisation après association.
  const correctionWins = item.source === 'manual' && item.at > chip.received_at;
  const explanation = replacing
    ? html`<p><strong>La fiche «&nbsp;<span class="nom-confirme">${item.name}</span>&nbsp;» porte déjà la puce <span class="uid">${item.uid_nfc}</span>.</strong></p>
<ul class="liste-causes">
<li>L'ancienne puce <span class="uid">${item.uid_nfc}</span> sera détachée de la fiche. Ses scans restent dans le journal et redeviennent ceux d'une puce inconnue.</li>
<li>La localisation de la fiche suivra désormais la nouvelle puce <span class="uid">${chip.uid}</span>, scannée en dernier : ${lastScan}.</li>
</ul>`
    : html`<p>La puce <span class="uid">${chip.uid}</span> sera associée à la fiche «&nbsp;<strong class="nom-confirme">${item.name}</strong>&nbsp;».</p>
<p>La fiche sera localisée au dernier scan de la puce : ${lastScan}.</p>`;

  return appLayout(user, title, html`<p class="retour"><a href="${search}">← Retour à la recherche</a></p>
<div class="entete-page">
<h1>${title}</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.associerConfirmation}${changed ? html`<p class="erreur" role="alert">La fiche a changé de puce depuis l'affichage de la page précédente : rien n'a été modifié. Vérifiez ci-dessous, puis confirmez à nouveau.</p>\n` : null}${reuseWarning(chip)}<div class="panneau ${replacing ? 'panneau-danger' : 'panneau-info'}">
${explanation}
${correctionWins ? html`<p class="texte-doux">Une correction manuelle de localisation plus récente que ce scan existe : elle reste la localisation de la fiche jusqu'au prochain scan de la puce.</p>\n` : null}<form method="post" action="${search}/${item.id}">
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
    back: BACK_TO_CHIPS,
    layout: chipsSection,
  });
}

/** La puce est (devenue) associée à une fiche : plus rien à faire ici. */
export function chipKnownPage(user, { uid, itemId }) {
  return messagePage(user, {
    title: 'Puce déjà associée',
    text: `La puce ${uid} est déjà associée à une fiche : elle n'est plus inconnue.`,
    hint: 'Rien n\'a été modifié.',
    back: BACK_TO_CHIPS,
    action: { href: `/items/${itemId}`, label: 'Voir la fiche' },
    layout: chipsSection,
  });
}
